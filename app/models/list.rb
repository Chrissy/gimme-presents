class List < ActiveRecord::Base
  include FriendlyId
  friendly_id :name, use: :slugged
  validates_presence_of :name, :slug
  has_many :gifts, -> { order("position DESC")}

  def url
    "/#{slug}"
  end

  def edit_link
    "/edit/#{id}"
  end

end
